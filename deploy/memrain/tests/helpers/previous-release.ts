/**
 * The release a live brain upgrades from: its tag and the last migration it
 * shipped. The release commit bumps it to the tag being cut.
 */
export const PREVIOUS_RELEASE = { tag: "v1.13.0", lastMigration: 145 } as const;
