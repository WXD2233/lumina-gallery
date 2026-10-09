export interface BackupImportAlbum {
  key: string;
  title: string;
  category: string;
  imageCount: number;
  linkCount: number;
  updatedAt: string;
  exists: boolean;
}

export interface BackupImportPreview {
  id: string;
  filename: string;
  format: 'zip' | 'xlsx';
  exportedAt?: string;
  albums: BackupImportAlbum[];
  categories: string[];
  warnings: string[];
}

export interface BackupImportResult {
  imported: number;
  skipped: number;
  imageCount: number;
  categoriesAdded: number;
}
