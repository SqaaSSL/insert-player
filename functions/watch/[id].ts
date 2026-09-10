// Only battle watch URLs need server-rendered social metadata. All other
// routes continue to use the static Pages app.
import { auraWatchPageResponse } from '../../scripts/aura-watch-page.mjs';

export const onRequest = auraWatchPageResponse;
