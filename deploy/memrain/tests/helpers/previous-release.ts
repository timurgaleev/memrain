/**
 * The release a live brain upgrades from: its tag and the last migration it
 * shipped. The release commit bumps it to the tag being cut.
 */
export const PREVIOUS_RELEASE = { tag: "v1.10.0", lastMigration: 143 } as const;
