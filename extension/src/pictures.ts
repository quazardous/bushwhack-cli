/**
 * A result announcing a picture the chat did not take — refused for a quota or a size —
 * would have the model describe what it never saw. Rewritten before sending, it says so.
 */
const ANNOUNCED = /^image: attached$/gm;
const SAID = 'a picture of the page, rendered from its DOM, is attached';

export const REFUSED_NOTE =
  'the picture could not be attached — the chat refused it (a quota, or its size). It is not in this message: do not describe the page from it; page:snapshot reads the page as text';

export function withoutPictures(text: string): string {
  return text.replace(ANNOUNCED, 'image: not attached').split(SAID).join(REFUSED_NOTE);
}
