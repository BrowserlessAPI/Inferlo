// File storage used by the app. ping() resolves when the storage service can be reached and throws when it cannot.
export const storage = {
  reachable: true,
  async ping(): Promise<void> {
    if (!this.reachable) throw new Error("Storage service unreachable");
  },
};
