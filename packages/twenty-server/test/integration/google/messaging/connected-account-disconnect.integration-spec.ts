import { ConnectedAccountProvider } from 'twenty-shared/types';
import { FIELD_RESTRICTED_ADDITIONAL_PERMISSIONS_REQUIRED } from 'twenty-shared/constants';
import { isDefined } from 'twenty-shared/utils';

import { gmailMessage } from 'test/integration/google/mocks/gmail-message.util';
import { setupGoogleMock } from 'test/integration/google/mocks/setup-google-mock.util';
import { connectMessagingAccount } from 'test/integration/utils/connect-messaging-account.util';
import {
  findRecordIdsByFilter,
  findRecordNodesByFilter,
} from 'test/integration/utils/find-records-by-filter.util';
import {
  disconnectConnectedAccount,
  queryMessageChannel,
} from 'test/integration/utils/query-messaging.util';
import { runMessageChannelSync } from 'test/integration/utils/run-message-channel-sync.util';

const HANDLE = 'messaging-disconnect@apple.dev';

describe('Messaging connected account disconnect (integration)', () => {
  const inbox = [gmailMessage(), gmailMessage()];

  setupGoogleMock({ handle: HANDLE, inbox });

  let channel: Awaited<ReturnType<typeof connectMessagingAccount>>;

  beforeAll(async () => {
    channel = await connectMessagingAccount({
      provider: ConnectedAccountProvider.GOOGLE,
      handle: HANDLE,
    });

    await runMessageChannelSync(channel.channelId);
  }, 60000);

  afterAll(async () => {
    await channel?.cleanup().catch(() => undefined);
  });

  it('keeps every imported message readable after the owner disconnects the account', async () => {
    const associations = await findRecordNodesByFilter<{
      id: string;
      messageId: string;
    }>(
      'messageChannelMessageAssociation',
      'messageChannelMessageAssociations',
      `id
        messageId`,
      { messageChannelId: { eq: channel.channelId } },
    );

    expect(associations).toHaveLength(inbox.length);

    const associationIds = associations.map((association) => association.id);
    const messageIds = associations.map((association) => association.messageId);

    const messagesBeforeDisconnect = await findRecordNodesByFilter<{
      id: string;
      subject: string;
      text: string;
      messageThreadId: string | null;
    }>(
      'message',
      'messages',
      `id
        subject
        text
        messageThreadId`,
      { id: { in: messageIds } },
    );

    expect(messagesBeforeDisconnect).toHaveLength(inbox.length);

    const threadIds = [
      ...new Set(
        messagesBeforeDisconnect.map((message) => message.messageThreadId),
      ),
    ].filter(isDefined);

    await disconnectConnectedAccount(channel.connectedAccountId);

    const messagesAfterDisconnect = await findRecordNodesByFilter<{
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

    expect(messagesAfterDisconnect).toHaveLength(inbox.length);

    for (const message of messagesAfterDisconnect) {
      const messageBeforeDisconnect = messagesBeforeDisconnect.find(
        (candidate) => candidate.id === message.id,
      );

      expect(message.subject).toBe(messageBeforeDisconnect?.subject);
      expect(message.text).toBe(messageBeforeDisconnect?.text);
      expect(message.subject).not.toBe(
        FIELD_RESTRICTED_ADDITIONAL_PERMISSIONS_REQUIRED,
      );
    }

    expect(
      await findRecordIdsByFilter(
        'messageChannelMessageAssociation',
        'messageChannelMessageAssociations',
        { messageChannelId: { eq: channel.channelId } },
      ),
    ).toHaveLength(inbox.length);
    expect(
      await findRecordIdsByFilter(
        'messageChannelMessageAssociationMessageFolder',
        'messageChannelMessageAssociationMessageFolders',
        { messageChannelMessageAssociationId: { in: associationIds } },
      ),
    ).not.toHaveLength(0);
    expect(
      await findRecordIdsByFilter('messageParticipant', 'messageParticipants', {
        messageId: { in: messageIds },
      }),
    ).not.toHaveLength(0);
    expect(
      await findRecordIdsByFilter('messageThread', 'messageThreads', {
        id: { in: threadIds },
      }),
    ).toHaveLength(threadIds.length);
  }, 60000);

  it('stops the sync and drops the credentials while keeping the channel row', async () => {
    const messageChannel = await queryMessageChannel({
      connectedAccountId: channel.connectedAccountId,
      channelId: channel.channelId,
    });

    expect(messageChannel.id).toBe(channel.channelId);

    const [connectedAccount] = await testDataSource.query(
      `SELECT "archivedAt", "accessToken", "refreshToken", "connectionParameters"
       FROM core."connectedAccount" WHERE id = $1`,
      [channel.connectedAccountId],
    );

    expect(connectedAccount.archivedAt).not.toBeNull();
    expect(connectedAccount.accessToken).toBeNull();
    expect(connectedAccount.refreshToken).toBeNull();
    expect(connectedAccount.connectionParameters).toBeNull();

    const [messageChannelRow] = await testDataSource.query(
      `SELECT "isSyncEnabled" FROM core."messageChannel" WHERE id = $1`,
      [channel.channelId],
    );

    expect(messageChannelRow.isSyncEnabled).toBe(false);
  }, 60000);
});
