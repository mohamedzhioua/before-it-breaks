// Test cases for scale-mongo-in-from-mapped-array (invented notes platform).

class NotificationCleanup {
  constructor(private noteModel: any, private notificationModel: any, private userModel: any) {}

  async purgeForWorkspace(workspaceId: string) {
    const notes = await this.noteModel.find({ workspaceId }, { _id: 1 });
    // ruleid: scale-mongo-in-from-mapped-array
    return this.notificationModel.deleteMany({ noteId: { $in: notes.map((n: any) => n._id) } });
  }

  async authorsOf(workspaceId: string) {
    const notes = await this.noteModel.find({ workspaceId }, { authorId: 1 });
    const authorIds = notes.map((n: any) => n.authorId);
    // ruleid: scale-mongo-in-from-mapped-array
    return this.userModel.find({ _id: { $in: authorIds } });
  }

  async markRead(userId: string, ids: string[]) {
    // ok: scale-mongo-in-from-mapped-array
    return this.notificationModel.updateMany({ userId, _id: { $in: ids } }, { $set: { read: true } });
  }

  async byLookup(workspaceId: string) {
    // ok: scale-mongo-in-from-mapped-array
    return this.noteModel.aggregate([
      { $match: { workspaceId } },
      { $lookup: { from: 'users', localField: 'authorId', foreignField: '_id', as: 'author' } },
    ]);
  }

  // Mapping a list in memory without a query is fine.
  labels(notes: any[]) {
    const titles = notes.map((n: any) => n.title);
    // ok: scale-mongo-in-from-mapped-array
    return titles.filter((t: string) => t.length > 0);
  }
}
