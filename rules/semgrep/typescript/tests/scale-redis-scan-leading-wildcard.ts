// Test cases for scale-redis-scan-leading-wildcard (invented notes platform).

class PresenceCache {
  constructor(private redis: any) {}

  async onlineInWorkspace(workspaceId: string) {
    // ruleid: scale-redis-scan-leading-wildcard
    const [, keys] = await this.redis.scan('0', 'MATCH', `*:presence:${workspaceId}`, 'COUNT', 500);
    return keys;
  }

  streamDrafts() {
    // ruleid: scale-redis-scan-leading-wildcard
    return this.redis.scanStream({ match: '*:draft', count: 200 });
  }

  async onlineByPrefix(workspaceId: string) {
    // ok: scale-redis-scan-leading-wildcard
    const [, keys] = await this.redis.scan('0', 'MATCH', `presence:${workspaceId}:*`, 'COUNT', 500);
    return keys;
  }

  // The keys are tracked in a set, so no scan is needed at all.
  async onlineFromSet(workspaceId: string) {
    // ok: scale-redis-scan-leading-wildcard
    return this.redis.smembers(`presence:${workspaceId}`);
  }
}
