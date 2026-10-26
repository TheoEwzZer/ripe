import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("purge expired sessions", { minutes: 30 }, internal.sessions.purgeExpired, {});

export default crons;
