import { randomBytes } from "node:crypto";

export const internalWorkerSecret: string = randomBytes(32).toString("hex");
