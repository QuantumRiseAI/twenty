import { randomUUID } from 'node:crypto';

import gql from 'graphql-tag';
import { FIELD_RESTRICTED_ADDITIONAL_PERMISSIONS_REQUIRED } from 'twenty-shared/constants';
import {
  CalendarChannelVisibility,
  ConnectedAccountProvider,
  MessageChannelVisibility,
} from 'twenty-shared/types';

import { SEED_APPLE_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';

import { gmailMessage } from 'test/integration/google/mocks/gmail-message.util';
import { googleCalendarEvent } from 'test/integration/google/mocks/google-calendar-event.util';
import { setupGoogleMock } from 'test/integration/google/mocks/setup-google-mock.util';
import { signUpInWorkspaceAndGetAccessToken } from 'test/integration/graphql/utils/sign-up-in-workspace-and-get-access-token.util';
import { makeMetadataAPIRequest } from 'test/integration/metadata/suites/utils/make-metadata-api-request.util';
import { connectMessagingAccount } from 'test/integration/utils/connect-messaging-account.util';
import {
  findRecordIdsByFilter,
  findRecordNodesByFilter,
} from 'test/integration/utils/find-records-by-filter.util';
import {
  deleteConnectedAccount,
  getDataOrThrow,
  updateCalendarChannel,
  updateMessageChannel,
} from 'test/integration/utils/query-messaging.util';
import { runCalendarChannelEventsImport } from 'test/integration/utils/run-calendar-channel-events-import.util';
import { runCalendarChannelListFetch } from 'test/integration/utils/run-calendar-channel-list-fetch.util';
import { runMessageChannelSync } from 'test/integration/utils/run-message-channel-sync.util';
import { waitForAllJobsToFinish } from 'test/integration/utils/wait-for-all-jobs-to-finish.util';

const HANDLE = 'messaging-custody@apple.dev';
const DEPARTING_MEMBER_EMAIL = 'messaging-custody-member@apple.dev';
const ADMIN_EMAIL = 'jane.austen@apple.dev';

const findUserWorkspaceIdByEmail = async (email: string): Promise<string> => {
  const [userWorkspace] = await testDataSource.query(
    `SELECT "userWorkspace".id
     FROM core."userWorkspace" "userWorkspace"
     JOIN core."user" "user" ON "user".id = "userWorkspace"."userId"
     WHERE "user".email = $1 AND "userWorkspace"."workspaceId" = $2`,
    [email, SEED_APPLE_WORKSPACE_ID],
  );

  return userWorkspace.id;
};

const deleteUserFromWorkspace = async (workspaceMemberId: string) => {
  const response = await makeMetadataAPIRequest({
    query: gql`
      mutation DeleteUserFromWorkspaceForTest(
        $workspaceMemberIdToDelete: String!
      ) {
        deleteUserFromWorkspace(
          workspaceMemberIdToDelete: $workspaceMemberIdToDelete
        ) {
          id
        }
      }
    `,
    variables: { workspaceMemberIdToDelete: workspaceMemberId },
  });

  getDataOrThrow(response);

  await waitForAllJobsToFinish();
};

describe('Messaging connected account custody on member removal (integration)', () => {
  const inbox = [gmailMessage(), gmailMessage()];
  const eventId = `google-calendar-event-${randomUUID()}`;

  const gmail = setupGoogleMock({ handle: HANDLE, inbox });

  let channel: Awaited<ReturnType<typeof connectMessagingAccount>>;
  let departingUserWorkspaceId: string;
  let adminUserWorkspaceId: string;
  let messageIds: string[];
  let calendarEventIds: string[];

  beforeAll(async () => {
    const departingMemberAccessToken = await signUpInWorkspaceAndGetAccessToken(
      DEPARTING_MEMBER_EMAIL,
    );

    departingUserWorkspaceId = await findUserWorkspaceIdByEmail(
      DEPARTING_MEMBER_EMAIL,
    );
    adminUserWorkspaceId = await findUserWorkspaceIdByEmail(ADMIN_EMAIL);

    channel = await connectMessagingAccount({
      provider: ConnectedAccountProvider.GOOGLE,
      handle: HANDLE,
      accessToken: departingMemberAccessToken,
    });

    await runMessageChannelSync(channel.channelId);

    gmail.serveCalendarEvents([
      googleCalendarEvent({
        id: eventId,
        attendees: [
          { email: `organizer-${eventId}@example.com`, organizer: true },
          { email: `attendee-${eventId}@example.com` },
        ],
      }),
    ]);

    await runCalendarChannelListFetch(channel.calendarChannelId);
    await runCalendarChannelEventsImport(channel.calendarChannelId);

    await updateMessageChannel(channel.channelId, {
      visibility: MessageChannelVisibility.METADATA,
    });

    await updateCalendarChannel(channel.calendarChannelId, {
      visibility: CalendarChannelVisibility.METADATA,
    });

    const associations = await findRecordNodesByFilter<{ messageId: string }>(
      'messageChannelMessageAssociation',
      'messageChannelMessageAssociations',
      'messageId',
      { messageChannelId: { eq: channel.channelId } },
    );

    messageIds = associations.map((association) => association.messageId);

    expect(messageIds).toHaveLength(inbox.length);

    const eventAssociations = await findRecordNodesByFilter<{
      calendarEventId: string;
    }>(
      'calendarChannelEventAssociation',
      'calendarChannelEventAssociations',
      'calendarEventId',
      { calendarChannelId: { eq: channel.calendarChannelId } },
    );

    calendarEventIds = eventAssociations.map(
      (association) => association.calendarEventId,
    );

    expect(calendarEventIds).toHaveLength(1);

    const [departingWorkspaceMember] = await findRecordNodesByFilter<{
      id: string;
    }>('workspaceMember', 'workspaceMembers', 'id', {
      userEmail: { eq: DEPARTING_MEMBER_EMAIL },
    });

    await deleteUserFromWorkspace(departingWorkspaceMember.id);
  }, 120000);

  afterAll(async () => {
    await deleteConnectedAccount(channel.connectedAccountId).catch(
      () => undefined,
    );
  });

  it('keeps the imported messages when the member leaves the workspace', async () => {
    expect(
      await findRecordIdsByFilter('message', 'messages', {
        id: { in: messageIds },
      }),
    ).toHaveLength(inbox.length);

    expect(
      await findRecordIdsByFilter(
        'messageChannelMessageAssociation',
        'messageChannelMessageAssociations',
        { messageChannelId: { eq: channel.channelId } },
      ),
    ).toHaveLength(inbox.length);
  }, 60000);

  it('keeps the imported calendar events when the member leaves the workspace', async () => {
    expect(
      await findRecordIdsByFilter('calendarEvent', 'calendarEvents', {
        id: { in: calendarEventIds },
      }),
    ).toHaveLength(calendarEventIds.length);

    expect(
      await findRecordIdsByFilter(
        'calendarChannelEventAssociation',
        'calendarChannelEventAssociations',
        { calendarChannelId: { eq: channel.calendarChannelId } },
      ),
    ).toHaveLength(calendarEventIds.length);

    expect(
      await findRecordIdsByFilter(
        'calendarEventParticipant',
        'calendarEventParticipants',
        { calendarEventId: { in: calendarEventIds } },
      ),
    ).not.toHaveLength(0);
  }, 60000);

  it('hands custody to the admin without reassigning the mailbox subject', async () => {
    const [connectedAccount] = await testDataSource.query(
      `SELECT "userWorkspaceId", "custodianUserWorkspaceId", "archivedAt", "accessToken"
       FROM core."connectedAccount" WHERE id = $1`,
      [channel.connectedAccountId],
    );

    expect(connectedAccount.custodianUserWorkspaceId).toBe(
      adminUserWorkspaceId,
    );
    expect(connectedAccount.userWorkspaceId).toBe(departingUserWorkspaceId);
    expect(connectedAccount.archivedAt).not.toBeNull();
    expect(connectedAccount.accessToken).toBeNull();

    const [messageChannelRow] = await testDataSource.query(
      `SELECT "isSyncEnabled" FROM core."messageChannel" WHERE id = $1`,
      [channel.channelId],
    );

    expect(messageChannelRow.isSyncEnabled).toBe(false);
  }, 60000);

  it('does not grant the custodian unrestricted read of the departed mailbox', async () => {
    const messages = await findRecordNodesByFilter<{
      id: string;
      subject: string;
      text: string;
    }>(
      'message',
      'messages',
      `id
        subject
        text`,
      { id: { in: messageIds } },
    );

    expect(messages).toHaveLength(inbox.length);

    for (const message of messages) {
      expect(message.subject).toBe(
        FIELD_RESTRICTED_ADDITIONAL_PERMISSIONS_REQUIRED,
      );
      expect(message.text).toBe(
        FIELD_RESTRICTED_ADDITIONAL_PERMISSIONS_REQUIRED,
      );
    }

    const calendarEvents = await findRecordNodesByFilter<{
      id: string;
      title: string;
    }>(
      'calendarEvent',
      'calendarEvents',
      `id
        title`,
      { id: { in: calendarEventIds } },
    );

    expect(calendarEvents).toHaveLength(calendarEventIds.length);

    for (const calendarEvent of calendarEvents) {
      expect(calendarEvent.title).toBe(
        FIELD_RESTRICTED_ADDITIONAL_PERMISSIONS_REQUIRED,
      );
    }
  }, 60000);
});
