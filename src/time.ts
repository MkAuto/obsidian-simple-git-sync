// Dates by hand, not with Obsidian's moment: Obsidian's plugin review type-checks without moment's types, so
// every moment() call reads as unsafe there.

/** Local time, written as `pattern` with moment's tokens YYYY MM DD HH mm ss SSS. */
export const format = (time: number, pattern: string) => {
	const d = new Date(time);
	const parts: Record<string, number> = {
		YYYY: d.getFullYear(),
		MM: d.getMonth() + 1,
		DD: d.getDate(),
		HH: d.getHours(),
		mm: d.getMinutes(),
		ss: d.getSeconds(),
		SSS: d.getMilliseconds(),
	};
	return pattern.replace(/YYYY|MM|DD|HH|mm|ss|SSS/g, (token) => String(parts[token]).padStart(token.length, '0'));
};

const relative = new Intl.RelativeTimeFormat('en');

/** "just now", "5 minutes ago", "2 hours ago", "3 days ago". */
export const ago = (time: number) => {
	const minutes = Math.floor((Date.now() - time) / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return relative.format(-minutes, 'minute');
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? relative.format(-hours, 'hour') : relative.format(-Math.floor(hours / 24), 'day');
};
