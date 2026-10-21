// Test cases for scale-unbounded-tenant-scoped-find (invented notes platform).

declare const Note: any;
declare const prisma: any;

class NotesService {
  constructor(private noteModel: any, private notesService: any) {}

  async exportAll(workspaceId: string) {
    // ruleid: scale-unbounded-tenant-scoped-find
    return this.noteModel.find({ workspaceId });
  }

  async archivedNotes(workspaceId: string) {
    // ruleid: scale-unbounded-tenant-scoped-find
    return this.noteModel.find({ archived: true, workspaceId: workspaceId });
  }

  async listForOwner(userId: string) {
    // ruleid: scale-unbounded-tenant-scoped-find
    const notes = await this.notesService.findMany({ ownerId: userId }, { title: 1 });
    return notes;
  }

  async exportWithModel(workspaceId: string) {
    // ruleid: scale-unbounded-tenant-scoped-find
    return Note.find({ workspaceId });
  }

  async prismaAll(workspaceId: string) {
    // ruleid: scale-unbounded-tenant-scoped-find
    return prisma.note.findMany({ where: { workspaceId, archived: false }, orderBy: { id: 'asc' } });
  }

  async prismaPage(workspaceId: string, cursor: string) {
    // ok: scale-unbounded-tenant-scoped-find
    return prisma.note.findMany({ where: { workspaceId }, take: 50, cursor: { id: cursor }, skip: 1 });
  }

  // Prisma filter on a non-tenant key.
  async prismaByTag(tag: string) {
    // ok: scale-unbounded-tenant-scoped-find
    return prisma.note.findMany({ where: { tag } });
  }

  async firstPageWithModel(workspaceId: string) {
    // ok: scale-unbounded-tenant-scoped-find
    return Note.find({ workspaceId }).limit(20);
  }

  async firstPage(workspaceId: string) {
    // ok: scale-unbounded-tenant-scoped-find
    return this.noteModel.find({ workspaceId }).sort({ _id: 1 }).limit(50);
  }

  async pageWithOptions(workspaceId: string) {
    // ok: scale-unbounded-tenant-scoped-find
    return this.notesService.findMany({ workspaceId }, { title: 1 }, { limit: 100 });
  }

  async streamAll(workspaceId: string) {
    // ok: scale-unbounded-tenant-scoped-find
    return this.noteModel.find({ workspaceId }).cursor();
  }

  async byTag(tag: string) {
    // ok: scale-unbounded-tenant-scoped-find
    return this.noteModel.find({ tag });
  }

  // findOne returns at most one document, whatever the tenant size.
  async pinnedNote(workspaceId: string) {
    // ok: scale-unbounded-tenant-scoped-find
    return this.noteModel.findOne({ workspaceId, pinned: true });
  }

  // A list held in memory is not a database query.
  pickDraft(draftStore: any, workspaceId: string) {
    // ok: scale-unbounded-tenant-scoped-find
    return draftStore.find({ workspaceId });
  }
}
