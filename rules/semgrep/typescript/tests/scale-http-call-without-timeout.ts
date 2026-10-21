// Test cases for scale-http-call-without-timeout (invented notes platform).
import axios from 'axios';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

class LinkPreviewService {
  constructor(private httpService: any) {}

  preview(url: string) {
    // ruleid: scale-http-call-without-timeout
    return this.httpService.get(url);
  }

  publish(url: string, note: any) {
    // ruleid: scale-http-call-without-timeout
    return this.httpService.post(url, note);
  }

  publishWithHeaders(url: string, note: any) {
    // ruleid: scale-http-call-without-timeout
    return this.httpService.post(url, note, { headers: { 'x-source': 'notes' } });
  }

  previewWithTimeout(url: string) {
    // ok: scale-http-call-without-timeout
    return this.httpService.get(url, { timeout: 5000 });
  }

  publishCancellable(url: string, note: any, signal: AbortSignal) {
    // ok: scale-http-call-without-timeout
    return this.httpService.post(url, note, { signal });
  }

  // A shared config object may carry the timeout; the rule does not judge it.
  publishWithShared(url: string, note: any, requestConfig: any) {
    // ok: scale-http-call-without-timeout
    return this.httpService.post(url, note, requestConfig);
  }

  // A Map lookup named get is not an HTTP call.
  cached(cache: Map<string, string>, key: string) {
    // ok: scale-http-call-without-timeout
    return cache.get(key);
  }
}

// ruleid: scale-http-call-without-timeout
const importsApi = axios.create({ baseURL: 'https://imports.example.test' });

// ruleid: scale-http-call-without-timeout
const bareApi = axios.create();

// ok: scale-http-call-without-timeout
const usersApi = axios.create({ baseURL: 'https://users.example.test', timeout: 3000 });

@Module({
  imports: [HttpModule],
  providers: [LinkPreviewService],
})
// ruleid: scale-http-call-without-timeout
class PreviewModule {}

@Module({
  imports: [HttpModule.register({ timeout: 5000 })],
  providers: [LinkPreviewService],
})
// ok: scale-http-call-without-timeout
class WebhookModule {}

@Module({
  imports: [HttpModule.register({ maxRedirects: 3 })],
  providers: [LinkPreviewService],
})
// ruleid: scale-http-call-without-timeout
class ExportModule {}

@Module({
  imports: [HttpModule.registerAsync({ useFactory: () => ({ timeout: 5000 }) })],
  providers: [LinkPreviewService],
})
// ok: scale-http-call-without-timeout
class SearchModule {}

// Direct axios calls inherit axios.defaults, which may be set in another file.
// ok: scale-http-call-without-timeout
export const pingUsers = () => axios.get('https://users.example.test/health');
