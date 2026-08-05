import { randomUUID } from 'node:crypto';

import { FIELD_RESTRICTED_ADDITIONAL_PERMISSIONS_REQUIRED } from 'twenty-shared/constants';
import { ConnectedAccountProvider } from 'twenty-shared/types';

import { googleCalendarEvent } from 'test/integration/google/mocks/google-calendar-event.util';
import { setupGoogleMock } from 'test/integration/google/mocks/setup-google-mock.util';
import { connectMessagingAccount } from 'test/integration/utils/connect-messaging-account.util';
import {
  findRecordIdsByFilter,
  findRecordNodesByFilter,
} from 'test/integration/utils/find-records-by-filter.util';
import { disconnectConnectedAccount } from 'test/integration/utils/query-messaging.util';
import { runCalendarChannelEventsImport } from 'test/integration/utils/run-calendar-channel-events-import.util';
import { runCalendarChannelListFetch } from 'test/integration/utils/run-calendar-channel-list-fetch.util';

const HANDLE = 'calendar-disconnect@apple.dev';

describe('Calendar connected account disconnect (integration)', () => {
  const eventId = `google-calendar-event-${randomUUID()}`;

  const gmail = setupGoogleMock({ handle: HANDLE });

  let channel: Awaited<ReturnType<typeof connectMessagingAccount>>;

  beforeAll(async () => {
    channel = await connectMessagingAccount({
      provider: ConnectedAccountProvider.GOOGLE,
      handle: HANDLE,
    });

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
  }, 60000);

  afterAll(async () => {
    await channel?.cleanup().catch(() => undefined);
  });

  it('keeps every imported calendar event readable after the owner disconnects the account', async () => {
    const associations = await findRecordNodesByFilter<{
      id: string;
      calendarEventId: string;
    }>(
      'calendarChannelEventAssociation',
      'calendarChannelEventAssociations',
      `id
        calendarEventId`,
      { calendarChannelId: { eq: channel.calendarChannelId } },
    );

    expect(associations).toHaveLength(1);

    const eventIds = associations.map(
      (association) => association.calendarEventId,
    );

    const eventsBeforeDisconnect = await findRecordNodesByFilter<{
      id: string;
      title: string;
    }>(
      'calendarEvent',
      'calendarEvents',
      `id
        title`,
      { id: { in: eventIds } },
    );

    expect(eventsBeforeDisconnect).toHaveLength(1);

    await disconnectConnectedAccount(channel.connectedAccountId);

    const eventsAfterDisconnect = await findRecordNodesByFilter<{
      id: string;
      title: string;
    }>(
      'calendarEvent',
      'calendarEvents',
      `id
        title`,
      { id: { in: eventIds } },
    );

    expect(eventsAfterDisconnect).toHaveLength(1);
    expect(eventsAfterDisconnect[0].title).toBe(
      eventsBeforeDisconnect[0].title,
    );
    expect(eventsAfterDisconnect[0].title).not.toBe(
      FIELD_RESTRICTED_ADDITIONAL_PERMISSIONS_REQUIRED,
    );

    expect(
      await findRecordIdsByFilter(
        'calendarChannelEventAssociation',
        'calendarChannelEventAssociations',
        { calendarChannelId: { eq: channel.calendarChannelId } },
      ),
    ).toHaveLength(1);
    expect(
      await findRecordIdsByFilter(
        'calendarEventParticipant',
        'calendarEventParticipants',
        { calendarEventId: { in: eventIds } },
      ),
    ).not.toHaveLength(0);

    const [calendarChannelRow] = await testDataSource.query(
      `SELECT "isSyncEnabled" FROM core."calendarChannel" WHERE id = $1`,
      [channel.calendarChannelId],
    );

    expect(calendarChannelRow.isSyncEnabled).toBe(false);
  }, 60000);
});
