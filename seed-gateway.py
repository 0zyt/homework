#!/usr/bin/env python3
import urllib.request, json
gw = {'addr': 'http://octobus:9000', 'token': 'bi-capset-demo-token-0001'}
req = urllib.request.Request(
    'http://agent-compose:7410/agentcompose.v2.SettingsService/UpdateCapabilityGatewayConfig',
    data=json.dumps(gw).encode(),
    headers={'Content-Type': 'application/json'},
    method='POST'
)
print('gateway:', urllib.request.urlopen(req).read().decode()[:200])
