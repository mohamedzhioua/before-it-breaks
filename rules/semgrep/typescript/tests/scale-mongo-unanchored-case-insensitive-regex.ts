// Test cases for scale-mongo-unanchored-case-insensitive-regex (invented notes platform).

class NoteSearch {
  constructor(private noteModel: any) {}

  byTitle(workspaceId: string, term: string) {
    // ruleid: scale-mongo-unanchored-case-insensitive-regex
    return this.noteModel.find({ workspaceId, title: { $regex: term, $options: 'i' } });
  }

  byBody(term: string) {
    // ruleid: scale-mongo-unanchored-case-insensitive-regex
    return this.noteModel.find({ body: { $regex: new RegExp(term, 'i') } });
  }

  byNumber(term: string) {
    return this.noteModel.aggregate([
      // ruleid: scale-mongo-unanchored-case-insensitive-regex
      { $match: { $expr: { $regexMatch: { input: { $toString: '$number' }, regex: term } } } },
    ]);
  }

  byPrefix(term: string) {
    // ok: scale-mongo-unanchored-case-insensitive-regex
    return this.noteModel.find({ slug: { $regex: `^${term}`, $options: 'i' } });
  }

  // Case-sensitive and anchored: an index on slug can serve this.
  bySlugPrefix(term: string) {
    // ok: scale-mongo-unanchored-case-insensitive-regex
    return this.noteModel.find({ slug: { $regex: '^' + term } });
  }

  byText(term: string) {
    // ok: scale-mongo-unanchored-case-insensitive-regex
    return this.noteModel.find({ $text: { $search: term } }).limit(20);
  }
}
