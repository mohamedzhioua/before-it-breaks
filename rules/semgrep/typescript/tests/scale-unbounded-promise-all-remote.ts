// Test cases for scale-unbounded-promise-all-remote (invented notes platform).
import axios from 'axios';
import { firstValueFrom } from 'rxjs';
import { map } from 'rxjs/operators';

declare const mailGateway: any;

class SearchSync {
  constructor(private searchClient: any, private httpService: any, private noteModel: any) {}

  async reindexAll(notes: any[]) {
    // ruleid: scale-unbounded-promise-all-remote
    await Promise.all(notes.map((n) => this.searchClient.index(n.id, n.body)));
  }

  async pingWebhooks(urls: string[]) {
    // ruleid: scale-unbounded-promise-all-remote
    return Promise.allSettled(urls.map(async (u) => firstValueFrom(this.httpService.post(u, {}))));
  }

  async fetchAvatars(users: any[]) {
    // ruleid: scale-unbounded-promise-all-remote
    return Promise.all(users.map((u) => axios.get(u.avatarUrl)));
  }

  notifyAll(users: any[]) {
    // ruleid: scale-unbounded-promise-all-remote
    users.forEach(async (u) => {
      await mailGateway.send(u.email, 'Weekly digest');
    });
  }

  async previews(urls: string[]) {
    // ruleid: scale-unbounded-promise-all-remote
    return Promise.all(urls.map((u) => firstValueFrom(this.httpService.get(u).pipe(map((r: any) => r.data)))));
  }

  // forEach over local work only.
  countWords(notes: any[]) {
    let total = 0;
    // ok: scale-unbounded-promise-all-remote
    notes.forEach((n) => { total += n.body.split(' ').length; });
    return total;
  }

  async reindexInChunks(notes: any[]) {
    for (let i = 0; i < notes.length; i += 50) {
      const chunk = notes.slice(i, i + 50);
      // ok: scale-unbounded-promise-all-remote
      await this.searchClient.indexMany(chunk);
    }
  }

  // Local database reads are not in the remote set.
  async loadOwners(notes: any[]) {
    // ok: scale-unbounded-promise-all-remote
    return Promise.all(notes.map((n) => this.noteModel.findById(n.parentId)));
  }

  // Pure CPU work per element.
  async renderAll(notes: any[]) {
    // ok: scale-unbounded-promise-all-remote
    return Promise.all(notes.map(async (n) => n.body.trim()));
  }
}
