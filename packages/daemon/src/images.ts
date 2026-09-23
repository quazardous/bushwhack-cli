/**
 * image:save — a picture the model generated in its chat (Meta AI's, Gemini's), put into
 * the project: a logo, an illustration. The model never sees an address for it; the
 * extension reads the pictures off the page and sends them with the call, the latest
 * first, and the call names one by its rank.
 */
import type { Picture, Result, ToolSpec } from '@bushwhack/protocol';
import { Workspace, WorkspaceError } from '@bushwhack/workspace';
import type { ToolRun } from './dispatcher.js';

/** A picture bigger than this is refused: the project is not a photo library. */
export const MAX_PICTURE_BYTES = 10 * 1024 * 1024;

const EXTENSIONS: Record<string, string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
};

export const IMAGE_TOOLS: ToolSpec[] = [
  {
    name: 'image:save',
    summary: 'Save into the project a picture you generated in this chat (a logo, an illustration).',
    approval: true,
    params: {
      path: { type: 'text', description: 'where to write it, with the extension of its type (the result of a wrong one says which)', required: true, maxLength: 300 },
      image: { type: 'int', description: 'which picture: 1 is the latest you generated in this conversation, 2 the one before', min: 1, max: 8, default: 1 },
    },
    notes: [
      'Generate the picture in your answer first, as you would for me; call image:save in that answer or a later one. The picture is saved as the chat made it (often WebP or PNG): name the file after its type.',
    ],
    example: { args: { path: 'public/logo.webp', image: '1' } },
  },
];

type Outcome = Omit<Result, 'tool' | 'id'>;

/** The bytes and type of a data: URL, or nothing when it is not a picture's. */
export function decodePicture(dataUrl: string): { type: string; bytes: Buffer } | undefined {
  const match = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match || !EXTENSIONS[match[1]]) return undefined;
  return { type: match[1], bytes: Buffer.from(match[2], 'base64') };
}

export async function runImageTool(workspace: Workspace, pictures: Picture[], call: ToolRun): Promise<Outcome> {
  const rank = Number(call.args.image ?? 1);
  const path = String(call.args.path);
  const picture = pictures[rank - 1];
  if (!picture) {
    return {
      status: 'error',
      content:
        pictures.length === 0
          ? 'no picture you generated is on the page — generate it in your answer first (in this chat, not described in words), then call image:save'
          : `there ${pictures.length === 1 ? 'is 1 picture' : `are ${pictures.length} pictures`} on the page; image ${rank} is not one of them`,
    };
  }
  if (picture.dataUrl === '') {
    // Its place kept by the extension: the page shows it, but its bytes could not be read.
    return { status: 'error', content: `picture ${rank} is on the page but could not be read from it (its server refused) — nothing was saved; tell me, I can save it by hand` };
  }
  const decoded = decodePicture(picture.dataUrl);
  if (!decoded) return { status: 'error', content: 'that picture could not be read as PNG, JPEG, WebP or GIF' };
  if (decoded.bytes.length > MAX_PICTURE_BYTES) return { status: 'error', content: `that picture is ${decoded.bytes.length} bytes; the most is ${MAX_PICTURE_BYTES}` };
  const allowed = EXTENSIONS[decoded.type];
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  if (!extension || !allowed.includes(extension)) {
    return { status: 'error', content: `that picture is ${decoded.type.slice('image/'.length).toUpperCase()}: name the file .${allowed[0]} — it is saved as the chat made it` };
  }
  try {
    const written = await workspace.writeBytes(path, decoded.bytes);
    const size = picture.width && picture.height ? `${picture.width}×${picture.height}, ` : '';
    return {
      status: 'ok',
      meta: { path: written.rel, bytes: written.bytes, type: decoded.type, created: written.created },
      content: `saved ${written.rel} (${size}${decoded.type}, ${written.bytes} bytes)`,
    };
  } catch (e) {
    if (e instanceof WorkspaceError) return { status: 'error', content: e.message };
    throw e;
  }
}
