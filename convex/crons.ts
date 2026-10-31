import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("purge expired sessions", { minutes: 30 }, internal.sessions.purgeExpired, {});
crons.interval("forget household history after 30 days", { hours: 6 }, internal.impact.purgeOld, {});
crons.interval("forget sent reminders", { hours: 12 }, internal.reminders.purgeOld, {});

export default crons;
