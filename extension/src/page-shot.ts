/**
 * A picture of the app page rendered from its DOM, not from the screen: the tab stays in
 * the background and nothing else on the screen can end up in it. Injected on demand into
 * the app tab (isolated world); page:screenshot then calls the function it leaves.
 */
import { domToJpeg } from 'modern-screenshot';

const MAX_WIDTH = 1280;
const MAX_HEIGHT = 4000;
const MAX_BYTES = 3 * 1024 * 1024;

type Shot = { ok: true; data: string } | { ok: false; error: string };

(globalThis as unknown as { __bushwhackShot: (selector: string | null) => Promise<Shot> }).__bushwhackShot = async (selector) => {
  let node: Element | null;
  try {
    node = selector ? document.querySelector(selector) : document.body;
  } catch {
    return { ok: false, error: `"${selector}" is not a valid selector` };
  }
  if (!node) return { ok: false, error: `nothing matches "${selector}"` };
  const box = node.getBoundingClientRect();
  const width = Math.max(1, Math.ceil(selector ? box.width : Math.max(box.width, document.documentElement.scrollWidth)));
  const height = Math.max(1, Math.ceil(selector ? box.height : Math.max(box.height, document.documentElement.scrollHeight)));
  const scale = Math.min(1, MAX_WIDTH / width);
  try {
    const data = await domToJpeg(node, {
      quality: 0.8,
      scale,
      height: Math.min(height, Math.floor(MAX_HEIGHT / scale)),
      backgroundColor: '#ffffff',
    });
    if (data.length > MAX_BYTES) return { ok: false, error: 'the picture is too large; take one element with a selector' };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `the page could not be rendered: ${(e as Error).message}` };
  }
};
