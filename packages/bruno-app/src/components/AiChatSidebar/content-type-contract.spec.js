/**
 * WHAT THE ASSISTANT CAN PROPOSE MUST BE WHAT THE RENDERER CAN APPLY.
 *
 * The two halves live in different processes and neither imports the other, so
 * for a long time they silently disagreed: the browser process accepted an
 * 'app' content type (ported wholesale from upstream, which ships an Apps
 * feature we do not), the model could call write_content('app'), the user got a
 * real Apply button — and accepting it fell through to `default: return` and did
 * nothing at all. A change the user approved was dropped on the floor.
 *
 * This pins the contract in the only direction that matters: anything the
 * browser process can offer has to have a dispatch on the other side, in every
 * one of the three targets (request / folder / collection).
 */

/* global __dirname */
const fs = require('fs');
const path = require('path');

const { CONTENT_TYPES } = require('../../../../bruno-electron/src/ipc/ai/chat-prompts');
const { CONTENT_TYPE_LABELS } = require('./constants');

// Read the switches out of the source rather than exercising the component:
// what is being pinned is which cases EXIST, and a rendered test can only ever
// prove the ones it happens to drive.
const readApplySwitches = () => {
  const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const chunks = src.split('switch (targetType) {').slice(1);
  return chunks.map((chunk) => {
    const body = chunk.split('default:')[0];
    return [...body.matchAll(/case '([^']+)'/g)].map((m) => m[1]).sort();
  });
};

describe('AI content types are the same set on both sides of the IPC boundary', () => {
  const expected = [...CONTENT_TYPES].sort();

  it('has three apply targets, so a miss in any one of them is caught', () => {
    expect(readApplySwitches()).toHaveLength(3);
  });

  it.each([0, 1, 2])('apply switch %i dispatches for every proposable type', (i) => {
    // Equality, not containment: an extra case is a type the model can never
    // reach, and a missing one is the silent-drop bug this file exists for.
    expect(readApplySwitches()[i]).toEqual(expected);
  });

  it('labels exactly the types it can apply', () => {
    expect(Object.keys(CONTENT_TYPE_LABELS).sort()).toEqual(expected);
  });
});
