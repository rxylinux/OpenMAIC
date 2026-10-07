/**
 * Client re-export used by the classroom quiz view: keeps the capture entry
 * points addressable under one short module specifier for dynamic import in
 * component code (the main client module remains the single implementation).
 */
export { buildMistakeCapturePayload, captureMistakesFromQuiz } from './client';
