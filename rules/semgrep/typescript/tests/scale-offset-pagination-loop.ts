// Test cases for scale-offset-pagination-loop (invented notes platform).

class NoteExporter {
  constructor(private noteModel: any, private writer: any) {}

  async exportWorkspace(workspaceId: string) {
    const pageSize = 500;
    let skip = 0;
    while (true) {
      const page = await this.noteModel.find({ workspaceId }).skip(skip).limit(pageSize);
      if (page.length === 0) break;
      await this.writer.write(page);
      // ruleid: scale-offset-pagination-loop
      skip += pageSize;
    }
  }

  async exportUsers() {
    let offset = 0;
    let rows: any[];
    do {
      rows = await this.writer.query('SELECT * FROM users ORDER BY id LIMIT 200 OFFSET $1', [offset]);
      // ruleid: scale-offset-pagination-loop
      offset = offset + rows.length;
    } while (rows.length > 0);
  }

  async exportByKeyset(workspaceId: string) {
    let lastId: any = null;
    let attempts = 0;
    while (true) {
      const filter = lastId ? { workspaceId, _id: { $gt: lastId } } : { workspaceId };
      const page = await this.noteModel.find(filter).sort({ _id: 1 }).limit(500);
      if (page.length === 0) break;
      lastId = page[page.length - 1]._id;
      // ok: scale-offset-pagination-loop
      attempts += 1;
    }
  }

  // Computing an offset once for a single page request is not a walk.
  pageOffset(page: number, size: number) {
    let offset = 0;
    // ok: scale-offset-pagination-loop
    offset += page * size;
    return offset;
  }
}
