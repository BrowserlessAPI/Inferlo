import { bullmqJobStore, type BullMQQueue, type BullMQWorker } from "@browserlessapi/inferlo/bullmq";

export function jobQueue(queue: BullMQQueue, worker: BullMQWorker) {
  return { store: bullmqJobStore(queue, worker) };
}
