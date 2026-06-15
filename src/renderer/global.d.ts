import type {
  BordeauxProject,
  ExportResult,
  ProjectFile,
  SaveResult,
  ValidationResult,
} from "../shared/types";

declare global {
  interface Window {
    bordeauxAPI?: {
      openProject(): Promise<ProjectFile | null>;
      openRecentProject(path: string): Promise<ProjectFile>;
      saveProject(project: BordeauxProject, path?: string | null): Promise<SaveResult>;
      exportBdx(project: BordeauxProject, outputPath?: string | null): Promise<ExportResult | { canceled: true }>;
      validateProject(project: BordeauxProject): Promise<ValidationResult>;
      showItemInFolder(path: string): Promise<void>;
      onMenuCommand(handler: (event: { command: string; payload?: unknown }) => void): () => void;
    };
  }
}

export {};
