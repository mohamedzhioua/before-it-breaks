// Test cases for scale-mongo-group-null-push (invented notes platform).

class WorkspaceStats {
  constructor(private noteModel: any) {}

  allNoteIds(workspaceId: string) {
    return this.noteModel.aggregate([
      { $match: { workspaceId } },
      // ruleid: scale-mongo-group-null-push
      { $group: { _id: null, ids: { $push: '$_id' }, total: { $sum: 1 } } },
    ]);
  }

  // Only a count and a sum: the output document has a fixed size.
  totals(workspaceId: string) {
    return this.noteModel.aggregate([
      { $match: { workspaceId } },
      // ok: scale-mongo-group-null-push
      { $group: { _id: null, total: { $sum: 1 }, words: { $sum: '$wordCount' } } },
    ]);
  }

  // Grouped by author: one output document per author, not one for everything.
  titlesByAuthor(workspaceId: string) {
    return this.noteModel.aggregate([
      { $match: { workspaceId } },
      // ok: scale-mongo-group-null-push
      { $group: { _id: '$authorId', titles: { $push: '$title' } } },
    ]);
  }
}
