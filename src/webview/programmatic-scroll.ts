/**
 * The programmatic-scroll flag: set right before a script-driven scroll so
 * the resulting `scroll` event is not mistaken for a user scroll (which
 * would cancel the anchor guard). The flag is consumed by the scroll event
 * it produces; the timer is only a safety net for scrolls that produce no
 * event (element already in place).
 */
let flag = false;
let timer: number | undefined;

export function markProgrammaticScroll(): void {
	flag = true;
	clearTimeout(timer);
	timer = setTimeout(() => {
		flag = false;
	}, 120);
}

/** Returns and clears the flag. */
export function consumeProgrammaticScroll(): boolean {
	const value = flag;
	flag = false;
	return value;
}
