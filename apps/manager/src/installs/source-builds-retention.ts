/**
 * How long a build nobody installs, updates from or throws away is kept.
 * The cron throws such builds away after this (record and files together),
 * so the sandbox Worker's bucket does not keep them forever. A week leaves
 * time to review a build started before a weekend; the files are a few MB
 * each, so keeping them longer would cost little but buy nothing.
 */
export const UNUSED_BUILD_DAYS = 7;

export const UNUSED_BUILD_MS = UNUSED_BUILD_DAYS * 24 * 60 * 60 * 1000;

/** What the review page says about it, for a build waiting for review. */
export const UNUSED_BUILD_NOTE = `A build nobody uses is thrown away ${UNUSED_BUILD_DAYS} days after it was built, with its files.`;
