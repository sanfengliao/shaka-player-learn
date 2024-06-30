import { registerDashParser } from './dash/dash_parser';
import './net/http_fetch_plugin';
import './net/http_xhr_plugin';
import './net/data_uri_plugin';
registerDashParser();
export * from './player';
