import { Redis } from "ioredis";

/** The company's shared Redis connection (also used by its BullMQ queues). It connects on its first command. */
export const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { lazyConnect: true, maxRetriesPerRequest: null });
