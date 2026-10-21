// Test cases for scale-queue-keeps-failed-jobs-forever (invented notes platform).

class ImportQueue {
  constructor(private queue: any) {}

  async enqueue(importId: string, csvText: string) {
    await this.queue.add(
      'parse-import',
      { importId, csvText },
      // ruleid: scale-queue-keeps-failed-jobs-forever
      { jobId: `import-${importId}`, removeOnComplete: true, removeOnFail: false },
    );
  }

  async enqueueBounded(importId: string, csvText: string) {
    // ok: scale-queue-keeps-failed-jobs-forever
    await this.queue.add('parse-import', { importId, csvText }, { removeOnComplete: true, removeOnFail: { count: 1000 } });
  }

  async enqueueAged(importId: string) {
    // ok: scale-queue-keeps-failed-jobs-forever
    await this.queue.add('parse-import', { importId }, { removeOnFail: { age: 7 * 24 * 3600 } });
  }

  // Keeping completed jobs is a different question; only failed jobs are in scope.
  async enqueueKeepDone(importId: string) {
    // ok: scale-queue-keeps-failed-jobs-forever
    await this.queue.add('parse-import', { importId }, { removeOnComplete: false, removeOnFail: true });
  }
}

const defaultJobOptions = {
  attempts: 3,
  // ruleid: scale-queue-keeps-failed-jobs-forever
  removeOnFail: false,
};
