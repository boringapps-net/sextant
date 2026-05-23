import { stringify } from 'yaml';

export function toYaml(obj: unknown): string {
  try {
    return stringify(obj, { indent: 2 });
  } catch (e: any) {
    return `# Failed to serialise: ${e?.message ?? e}`;
  }
}
