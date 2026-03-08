import type { Env, Character } from './types';
import { generateId, hashString } from './auth';

const SPRITE_ANIMATIONS = [
  { name: 'idle', prompt: 'character standing in fighting stance, breathing idle animation' },
  { name: 'walk', prompt: 'character walking forward, side view, fighting game walk cycle' },
  { name: 'light_punch', prompt: 'character throwing a quick jab punch, side view' },
  { name: 'heavy_punch', prompt: 'character throwing a powerful cross punch, full arm extension' },
  { name: 'light_kick', prompt: 'character performing a quick front kick, side view' },
  { name: 'heavy_kick', prompt: 'character performing a powerful roundhouse kick' },
  { name: 'jump', prompt: 'character jumping upward, tucked pose at peak' },
  { name: 'crouch', prompt: 'character crouching down in defensive stance' },
  { name: 'hit', prompt: 'character recoiling from being struck, pain reaction' },
  { name: 'ko', prompt: 'character falling to the ground, knocked out' },
];

export async function uploadPhoto(
  request: Request,
  env: Env,
  userId: string
): Promise<Response> {
  const formData = await request.formData();
  const photo = formData.get('photo') as File | null;
  const name = (formData.get('name') as string) || 'Fighter';

  if (!photo) {
    return Response.json({ error: 'No photo provided' }, { status: 400 });
  }

  if (photo.size > 10 * 1024 * 1024) {
    return Response.json({ error: 'Photo must be under 10MB' }, { status: 400 });
  }

  const photoBytes = await photo.arrayBuffer();
  const photoHash = await hashString(new Uint8Array(photoBytes).toString());

  const existing = await env.DB.prepare(
    'SELECT * FROM characters WHERE user_id = ? AND photo_hash = ?'
  ).bind(userId, photoHash).first<Character>();

  if (existing && existing.sprite_status === 'ready') {
    return Response.json({ character: existing });
  }

  const charId = existing?.id ?? generateId();
  const photoR2Key = `photos/${userId}/${charId}/original.png`;

  await env.SPRITES.put(photoR2Key, photoBytes, {
    httpMetadata: { contentType: photo.type },
  });

  if (!existing) {
    await env.DB.prepare(
      'INSERT INTO characters (id, user_id, name, photo_hash, sprite_status) VALUES (?, ?, ?, ?, ?)'
    ).bind(charId, userId, name, photoHash, 'processing').run();
  } else {
    await env.DB.prepare(
      'UPDATE characters SET sprite_status = ?, name = ? WHERE id = ?'
    ).bind('processing', name, charId).run();
  }

  // TODO: Trigger async sprite generation pipeline
  // For now, return the character with 'processing' status
  // The client will poll for completion

  const character = await env.DB.prepare(
    'SELECT * FROM characters WHERE id = ?'
  ).bind(charId).first<Character>();

  return Response.json({ character });
}

export async function getCharacter(
  env: Env,
  characterId: string,
  userId: string
): Promise<Response> {
  const character = await env.DB.prepare(
    'SELECT * FROM characters WHERE id = ? AND user_id = ?'
  ).bind(characterId, userId).first<Character>();

  if (!character) {
    return Response.json({ error: 'Character not found' }, { status: 404 });
  }

  return Response.json({ character });
}

export async function listCharacters(
  env: Env,
  userId: string
): Promise<Response> {
  const { results } = await env.DB.prepare(
    'SELECT * FROM characters WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all<Character>();

  return Response.json({ characters: results });
}

export async function getSpriteAsset(
  env: Env,
  key: string
): Promise<Response> {
  const object = await env.SPRITES.get(key);
  if (!object) {
    return new Response('Not found', { status: 404 });
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'image/png');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  return new Response(object.body, { headers });
}
