import { Container } from '@cloudflare/containers';
import type { Env } from './types';

export class ImageProcessorContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '5m';
  pingEndpoint = '/health';
  enableInternet = true;
}
