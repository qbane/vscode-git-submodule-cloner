// extracted from official VS Code codebase to compute the workspace ID from folder URI
// see:
// - src/vs/workbench/services/workspaces/browser/workspaces.ts
// - src/vs/base/common/hash.ts

import type { Uri } from 'vscode'

export function getWorkspaceId(uri: Uri): string {
	return hash(uri.toString()).toString(16);
}

export function hash(str: string): number {
	return stringHash(str, 0);
}

function stringHash(s: string, hashVal: number) {
	hashVal = numberHash(149417, hashVal);
	for (let i = 0, length = s.length; i < length; i++) {
		hashVal = numberHash(s.charCodeAt(i), hashVal);
	}
	return hashVal;
}

function numberHash(val: number, initialHashVal: number): number {
	return (((initialHashVal << 5) - initialHashVal) + val) | 0;  // hashVal * 31 + ch, keep as int32
}
