<?php
/*
 * Renders spec/catalog.json's `data` and `meta`: GET /api/v1/webhooks/events exactly as accounts answers it, from the
 * code of a tag (WebhookEventCatalogController::index without Laravel). Only the catalog classes, the device event
 * builders and platform-gate's Event are loaded; nothing touches a database.
 *
 *   mkdir -p /tmp/cat/accounts /tmp/cat/gate
 *   git -C ../accounts archive v1.5.97 back/app/Modules/Webhook | tar -x -C /tmp/cat/accounts
 *   git -C ../platform-gate archive v0.9.1 src | tar -x -C /tmp/cat/gate      # the version of accounts' composer.lock
 *   php scripts/transcribe-catalog.php /tmp/cat/accounts/back/app /tmp/cat/gate/src > /tmp/cat/catalog.json
 *
 * Then copy `data` to `entries` of spec/catalog.json and update its `source`. Checked on 04-11 against the v1.4.24
 * transcription: identical.
 */
declare(strict_types=1);

[$_, $appDir, $gateDir] = $argv;

spl_autoload_register(function (string $class) use ($appDir, $gateDir): void {
    $map = ['App\\' => $appDir.'/', 'Funnelchat\\PlatformGate\\' => $gateDir.'/'];
    foreach ($map as $prefix => $dir) {
        if (str_starts_with($class, $prefix)) {
            $file = $dir.str_replace('\\', '/', substr($class, strlen($prefix))).'.php';
            if (is_file($file)) {
                require $file;
            }
            return;
        }
    }
});

use App\Modules\Webhook\Catalogs\WebhookEventCatalog;
use Funnelchat\PlatformGate\Webhooks\Signature;

$entries = array_map(
    function (array $entry) {
        unset($entry['example_data'], $entry['relay_sources']);
        return $entry + ['example' => WebhookEventCatalog::example($entry['type'])];
    },
    WebhookEventCatalog::all(),
);

echo json_encode([
    'data' => $entries,
    'meta' => [
        'total' => count($entries),
        'active' => count(array_filter($entries, fn (array $e) => $e['status'] === WebhookEventCatalog::STATUS_ACTIVE)),
        'envelope_version' => WebhookEventCatalog::ENVELOPE_VERSION,
        'signature_header' => Signature::HEADER,
        'signature_format' => 't=<unix>,v1=<hex hmac-sha256 de "<t>.<cuerpo crudo>" con el secreto del endpoint>',
    ],
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT), "\n";
