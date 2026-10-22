// The version shown in the dashboard and the phone admin: the same single source as the kids page
// (package.json "version", AUDIT L9). The old fixed "1.4.0" came from web_project and was never updated.
import { HUB_VERSION } from '../shared/hub';

export const APP_VERSION = HUB_VERSION;
