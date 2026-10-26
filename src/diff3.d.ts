declare module 'diff3' {
	type Block = { ok: string[]; conflict?: undefined } | { ok?: undefined; conflict: { a: string[]; o: string[]; b: string[] } };
	/** Three-way merge of line arrays: a = ours, o = base, b = theirs. */
	export default function diff3Merge(a: string[], o: string[], b: string[]): Block[];
}
