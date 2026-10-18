/** Read-only compatibility export. No writes, migration, or active browser persistence. */
export async function exportLegacyExams(): Promise<void> {
  const databases = await indexedDB.databases();
  if (!databases.some((db) => db.name === 'keyval-store'))
    throw new Error('No old browser exams found.');
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('keyval-store');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    if (!db.objectStoreNames.contains('keyval'))
      throw new Error('No old browser exams found.');
    const exams = await new Promise<unknown[]>((resolve, reject) => {
      const out: unknown[] = [];
      const tx = db.transaction('keyval', 'readonly');
      const request = tx.objectStore('keyval').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (String(cursor.key).startsWith('exam:')) out.push(cursor.value);
        cursor.continue();
      };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
    });
    if (!exams.length) throw new Error('No old browser exams found.');
    for (const exam of exams) {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(exam, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `legacy-${(exam as { id: string }).id}.json`;
      link.click();
      URL.revokeObjectURL(url);
    }
  } finally {
    db.close();
  }
}
