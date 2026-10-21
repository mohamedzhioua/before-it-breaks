// Test cases for scale-mongoose-push-update-result-discarded (invented notes platform).

class ImportLog {
  constructor(private importModel: any, private noteModel: any) {}

  async recordRow(importId: string, row: any) {
    // ruleid: scale-mongoose-push-update-result-discarded
    await this.importModel.findByIdAndUpdate(importId, { $push: { rows: row } });
  }

  recordError(importId: string, message: string) {
    // ruleid: scale-mongoose-push-update-result-discarded
    this.importModel.findOneAndUpdate({ _id: importId }, { $push: { errors: message }, $inc: { failed: 1 } });
  }

  async recordRowCheap(importId: string, row: any) {
    // ok: scale-mongoose-push-update-result-discarded
    await this.importModel.updateOne({ _id: importId }, { $push: { rows: row } });
  }

  async addTagAndReturn(noteId: string, tag: string) {
    // ok: scale-mongoose-push-update-result-discarded
    const note = await this.noteModel.findByIdAndUpdate(noteId, { $push: { tags: tag } }, { new: true });
    return note.tags.length;
  }

  async addTag(noteId: string, tag: string) {
    // ok: scale-mongoose-push-update-result-discarded
    return this.noteModel.findByIdAndUpdate(noteId, { $push: { tags: tag } }, { new: true });
  }

  async rename(noteId: string, title: string) {
    // ok: scale-mongoose-push-update-result-discarded
    await this.noteModel.findByIdAndUpdate(noteId, { $set: { title } });
  }
}
