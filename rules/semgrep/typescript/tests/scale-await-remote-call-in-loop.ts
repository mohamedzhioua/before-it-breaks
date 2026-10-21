// Test cases for scale-await-remote-call-in-loop (invented notes platform).
import axios from 'axios';
import got from 'got';
import { firstValueFrom, lastValueFrom } from 'rxjs';
import { map } from 'rxjs/operators';

declare const searchClient: any;
declare const noteRepo: any;

class ImportRunner {
  constructor(
    private httpService: any,
    private eventEmitter: any,
    private searchClient: any,
    private mailGateway: any,
    private noteModel: any,
    private cache: any,
  ) {}

  async pushRows(rows: any[]) {
    for (const row of rows) {
      // ruleid: scale-await-remote-call-in-loop
      await fetch('https://search.example.test/index', { method: 'POST', body: JSON.stringify(row) });
    }
  }

  async notifyWatchers(watchers: any[]) {
    for (let i = 0; i < watchers.length; i++) {
      // ruleid: scale-await-remote-call-in-loop
      await this.mailGateway.send(watchers[i].email, 'A note changed');
    }
  }

  async reindex(noteIds: string[]) {
    for (const id of noteIds) {
      // ruleid: scale-await-remote-call-in-loop
      await this.searchClient.upsert(id);
    }
  }

  async webhooks(urls: string[]) {
    let i = 0;
    while (i < urls.length) {
      // ruleid: scale-await-remote-call-in-loop
      await firstValueFrom(this.httpService.post(urls[i], {}));
      i++;
    }
  }

  async legacy(urls: string[]) {
    for (const url of urls) {
      // ruleid: scale-await-remote-call-in-loop
      await axios.get(url);
      // ruleid: scale-await-remote-call-in-loop
      await got(url);
    }
  }

  async fanOutEvents(notes: any[]) {
    for (const note of notes) {
      // ruleid: scale-await-remote-call-in-loop
      await this.eventEmitter.emitAsync('note.imported', note);
    }
  }

  async previews(urls: string[]) {
    for (const url of urls) {
      // ruleid: scale-await-remote-call-in-loop
      await firstValueFrom(this.httpService.get(url).pipe(map((r: any) => r.data)));
      // ruleid: scale-await-remote-call-in-loop
      await lastValueFrom(this.httpService.head(url));
    }
  }

  async reindexWithModuleClient(noteIds: string[]) {
    for (const id of noteIds) {
      // ruleid: scale-await-remote-call-in-loop
      await searchClient.upsert(id);
      // ok: scale-await-remote-call-in-loop
      await noteRepo.save({ id, indexed: true });
    }
  }

  async previewsInChunks(urls: string[]) {
    for (let i = 0; i < urls.length; i += 20) {
      // ok: scale-await-remote-call-in-loop
      await Promise.all(urls.slice(i, i + 20).map((u) => firstValueFrom(this.httpService.get(u, { timeout: 5000 }))));
    }
  }

  async batched(noteIds: string[]) {
    // ok: scale-await-remote-call-in-loop
    await this.searchClient.upsertMany(noteIds);
  }

  async localWrites(notes: any[]) {
    for (const note of notes) {
      // ok: scale-await-remote-call-in-loop
      await this.noteModel.updateOne({ _id: note.id }, { $set: { seen: true } });
      // ok: scale-await-remote-call-in-loop
      await this.cache.del(note.id);
    }
  }

  async concurrentInsideMap(noteIds: string[]) {
    for (const chunk of [noteIds]) {
      await Promise.all(
        chunk.map(async (id) => {
          // ok: scale-await-remote-call-in-loop
          await this.searchClient.upsert(id);
        }),
      );
    }
  }
}
