/**
 * @bushwhack/secrets — declared secret files.
 *
 * The operator names the files that hold secrets; the chat sees their variable names and
 * never a value; values are changed by name and masked wherever else they show up. No
 * dependency on the rest of bushwhack: it knows files and formats, not tools or chats.
 */
export { SecretFiles, DeclarationError, DECLARATIONS, DECLARATIONS_TEMPLATE, MIN_MASKED_LENGTH } from './files.js';
export type { SecretFormat } from './files.js';
export { parseDotenv, scrambleDotenv, setDotenv, removeDotenv, dotenvValues, placeholder, NAME_RE } from './dotenv.js';
export type { Line } from './dotenv.js';
