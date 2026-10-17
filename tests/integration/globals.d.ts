declare const browser: {
  runtime: { id: string; getURL(path: string): string }
  tabs: {
    query(query: { active?: boolean; currentWindow?: boolean }): Promise<Array<{ url?: string }>>
  }
}
