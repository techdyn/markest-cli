/**
 * The secret guard (cli/publish/secret-guard): files that hold keys are known by
 * name and by what they hold, and each pattern holds at its edges - a word apart
 * from another, the end of a name, the length of a token - so a key is caught and
 * prose about keys is not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { secretByName, secretInContent } from '../src/publish/secret-guard.mjs';

test('the secret guard knows the shapes of keys', () => {
    assert.equal(secretByName('config/credentials.yml'), 'secret_name');
    assert.equal(secretByName('id_ed25519'), 'secret_name');
    assert.equal(secretByName('docs/credentials.md'), null);
    assert.equal(secretByName('secretary.json'), null);
    assert.equal(secretInContent('-----BEGIN RSA ' + 'PRIVATE KEY-----'), 'private_key');
    assert.equal(secretInContent('sk_live_' + 'A1'.repeat(12)), 'stripe_key');
    assert.equal(secretInContent('ghp_' + 'a'.repeat(36)), 'github_token');
    assert.equal(secretInContent('AKIA' + 'ABCDEFGHIJKLMNOP'), 'aws_key');
    assert.equal(secretInContent('xoxb-' + '1234567890-abc'), 'slack_token');
    assert.equal(secretInContent('mk_live_…'), null, 'a key already redacted is none');
    assert.equal(secretInContent('an ordinary page'), null);
});

test('a credentials or secrets file is known in either number, as a word of its own, with or without an extension', () => {
    for (const name of ['credential.json', 'credentials', 'secret.yaml', 'secrets', 'app-secrets.json', 'db.credentials.ini', 'prod_secret.toml']) {
        assert.equal(secretByName('config/' + name), 'secret_name', name);
    }
    for (const name of ['mycredentials.json', 'topsecrets.json', 'credentialsx.json', 'secretsauce.yml']) {
        assert.equal(secretByName(name), null, name + ' is another word');
    }
});

test('a service account, an SSH key and a key file are known by their whole names', () => {
    assert.equal(secretByName('service-account.json'), 'secret_name');
    assert.equal(secretByName('serviceaccount-prod.json'), 'secret_name');
    assert.equal(secretByName('service_account.JSON'), 'secret_name');
    assert.equal(secretByName('my-service-account.json'), null, 'only a name that starts so');
    assert.equal(secretByName('service-account.json.example'), null, 'only one that ends .json');
    assert.equal(secretByName('id_rsa'), 'secret_name');
    assert.equal(secretByName('id_rsa.pub'), null, 'a public key is no secret');
    assert.equal(secretByName('old_id_rsa'), null);
    for (const name of ['server.pem', 'tls.key', 'store.p12', 'cert.pfx', 'app.keystore', 'trust.jks', 'vault.kdbx', 'main.tfstate', 'prod.tfvars', 'office.ovpn', 'main.tfstate.backup']) {
        assert.equal(secretByName(name), 'secret_name', name);
    }
    assert.equal(secretByName('server.pem.txt'), null, 'prose, whatever its name holds');
    assert.equal(secretByName('server.pem.sample'), null, 'only a name that ends so');
    assert.equal(secretByName('main.tfstate.backup.old'), null);
});

test('prose about keys is judged by what it holds alone, whatever its name', () => {
    for (const name of ['credentials.md', 'secrets.markdown', 'id_rsa.txt', 'credentials.htm', 'credentials.html', 'secrets.xhtml', 'secret.mdown', 'secret.mkd', 'secret.text']) {
        assert.equal(secretByName(name), null, name);
    }
    assert.equal(secretByName('credentials.md.json'), 'secret_name', 'a name ending in a data type is no prose');
});

test('a token is known at its own length, and not shorter', () => {
    assert.equal(secretInContent('github_pat_' + 'A'.repeat(40)), 'github_token');
    assert.equal(secretInContent('github_pat_' + 'A'.repeat(39)), null);
    assert.equal(secretInContent('github_pat_' + '-'.repeat(40)), null, 'its own alphabet');
    assert.equal(secretInContent('ghp_' + 'a'.repeat(35)), null);
    assert.equal(secretInContent('xoxb-12345'), null, 'a Slack token is longer');
    assert.equal(secretInContent('xoxb-' + '1234567890'), 'slack_token');
    assert.equal(secretInContent('mk_live_' + '0f'.repeat(16)), 'markest_key');
    assert.equal(secretInContent('mk_live_' + '0f'.repeat(15)), null);
    assert.equal(secretInContent('rk_live_' + 'a'.repeat(20)), 'stripe_key');
    assert.equal(secretInContent('sk_test_' + 'a'.repeat(20)), null, 'a test key is not a live one');
    assert.equal(secretInContent('ASIA' + 'ABCDEFGHIJKLMNOP'), 'aws_key');
    assert.equal(secretInContent('-----BEGIN ' + 'PRIVATE KEY-----'), 'private_key');
    assert.equal(secretInContent('-----BEGIN PUBLIC KEY-----'), null);
});
