// Test cases for scale-swallowed-remote-error-then-bulk-write (invented notes platform).
import { firstValueFrom } from 'rxjs';
import { retry } from 'rxjs/operators';

declare const smtpClient: any;

class NotificationSender {
  constructor(private pushClient: any, private notificationModel: any, private logger: any, private httpService: any) {}

  async sendPending(pending: any[]) {
    for (const n of pending) {
      try {
        await this.pushClient.send(n.userId, n.body);
      } catch (err) {
        this.logger.warn('push failed', err);
      }
    }
    // ruleid: scale-swallowed-remote-error-then-bulk-write
    await this.notificationModel.updateMany({ _id: { $in: pending.map((n) => n._id) } }, { $set: { sent: true } });
  }

  async mirrorToWebhook(pending: any[]) {
    for (const n of pending) {
      try {
        await fetch('https://hooks.example.test/notify', { method: 'POST', body: JSON.stringify(n) });
      } catch (err) {
        this.logger.warn('webhook failed', err);
      }
    }
    // ruleid: scale-swallowed-remote-error-then-bulk-write
    await this.notificationModel.deleteMany({ _id: { $in: pending.map((n) => n._id) } });
  }

  async sendAndTrack(pending: any[]) {
    const sentIds: string[] = [];
    for (const n of pending) {
      try {
        await this.pushClient.send(n.userId, n.body);
        sentIds.push(n._id);
      } catch (err) {
        this.logger.warn('push failed', err);
      }
    }
    // Known false positive: only the ids that succeeded are written, but the rule
    // cannot see that. Kept as todook so a future refinement is measured.
    // todook: scale-swallowed-remote-error-then-bulk-write
    await this.notificationModel.updateMany({ _id: { $in: sentIds } }, { $set: { sent: true } });
  }

  async sendEmails(pending: any[]) {
    for (const n of pending) {
      try {
        await smtpClient.deliver(n.to, n.body);
      } catch (err) {
        this.logger.warn('email failed', err);
      }
    }
    // ruleid: scale-swallowed-remote-error-then-bulk-write
    await this.notificationModel.updateMany({ _id: { $in: pending.map((n) => n._id) } }, { $set: { sent: true } });
  }

  async relay(pending: any[]) {
    for (const n of pending) {
      try {
        await firstValueFrom(this.httpService.post(n.url, n.body).pipe(retry(2)));
      } catch (err) {
        this.logger.warn('relay failed', err);
      }
    }
    // ruleid: scale-swallowed-remote-error-then-bulk-write
    await this.notificationModel.deleteMany({ _id: { $in: pending.map((n) => n._id) } });
  }

  async sendStrict(pending: any[]) {
    for (const n of pending) {
      await this.pushClient.send(n.userId, n.body);
    }
    // ok: scale-swallowed-remote-error-then-bulk-write
    await this.notificationModel.updateMany({ _id: { $in: pending.map((n) => n._id) } }, { $set: { sent: true } });
  }

  // The try/catch guards a local parse, not a remote call.
  async normalise(pending: any[]) {
    for (const n of pending) {
      try {
        n.body = JSON.parse(n.raw);
      } catch (err) {
        n.body = null;
      }
    }
    // ok: scale-swallowed-remote-error-then-bulk-write
    await this.notificationModel.bulkWrite(pending.map((n) => ({ updateOne: { filter: { _id: n._id }, update: { $set: { body: n.body } } } })));
  }
}
