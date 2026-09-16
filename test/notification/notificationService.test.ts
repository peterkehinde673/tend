import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ConsoleNotificationService, DigestNotification } from '../../src/notification/notificationService';

function makeNotification(overrides: Partial<DigestNotification> = {}): DigestNotification {
  return {
    householdId: 'house-1',
    severity: 'MODERATE',
    explanation: 'No activity has been observed in the kitchen past the usual window.',
    recommendedWording: 'Consider checking in.',
    notifyRecommended: true,
    ...overrides,
  };
}

describe('notification/notificationService: ConsoleNotificationService', () => {
  test('reports delivered:true and prints when notifyRecommended is true', async () => {
    const originalLog = console.log;
    let loggedLine: string | undefined;
    console.log = (line: string) => {
      loggedLine = line;
    };
    try {
      const service = new ConsoleNotificationService();
      const result = await service.send(makeNotification());
      assert.equal(result.delivered, true);
      assert.ok(loggedLine?.includes('MODERATE'));
      assert.ok(loggedLine?.includes('house-1'));
    } finally {
      console.log = originalLog;
    }
  });

  test('does NOT print and reports delivered:false when notifyRecommended is false, honoring the reasoning layer', async () => {
    const originalLog = console.log;
    let logCalled = false;
    console.log = () => {
      logCalled = true;
    };
    try {
      const service = new ConsoleNotificationService();
      const result = await service.send(makeNotification({ notifyRecommended: false }));
      assert.equal(result.delivered, false);
      assert.ok(result.reason);
      assert.equal(logCalled, false);
    } finally {
      console.log = originalLog;
    }
  });

  test('only ever prints fields already present on DigestNotification, never anything else', async () => {
    const originalLog = console.log;
    let loggedLine: string | undefined;
    console.log = (line: string) => {
      loggedLine = line;
    };
    try {
      const notification = makeNotification({ explanation: 'UNIQUE_MARKER_TEXT_12345' });
      const service = new ConsoleNotificationService();
      await service.send(notification);
      assert.ok(loggedLine?.includes('UNIQUE_MARKER_TEXT_12345'));
    } finally {
      console.log = originalLog;
    }
  });
});
