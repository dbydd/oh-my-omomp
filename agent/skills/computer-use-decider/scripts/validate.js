/** Minimal type checks shared by the decider helper. */

export function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

export function isFinite(value) {
	return typeof value === "number" && Number.isFinite(value);
}
