import type { BookViewAPI } from './BookViewAPI';

declare global {
	interface Window {
		BookView?: BookViewAPI;
	}
}
