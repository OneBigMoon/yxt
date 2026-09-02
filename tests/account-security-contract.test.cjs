const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('login uses a deterministic identity, screens new nicknames and honors admin deletion', () => {
  const source = read('cloudfunctions/login/index.js')
  const nicknameCheckAt = source.indexOf('await assertSafeNickname(loginNickName, OPENID)')
  const createAt = source.indexOf("doc(userDocumentId(OPENID)).set")
  const tombstoneCheckAt = source.indexOf("identityRecord.status === 'deleted'")
  const technicianLookupAt = source.indexOf('technicianInfo = await findActiveTechnicianByPhone')

  assert.match(source, /function userDocumentId\(openid\)[\s\S]{0,120}createHash\('sha256'\)\.update\(openid\)/)
  assert.match(source, /identityRecord && identityRecord\.status === 'deleted' && identityRecord\.deleted_by_admin/)
  assert.match(source, /doc\(userDocumentId\(OPENID\)\)\.set\(\{ data: newUser \}\)/)
  assert.doesNotMatch(source, /collection\('users'\)\.add\(/)
  assert.ok(tombstoneCheckAt >= 0 && technicianLookupAt > tombstoneCheckAt, 'admin deletion must be checked before role binding')
  assert.ok(nicknameCheckAt >= 0 && createAt > nicknameCheckAt, 'nickname safety must run before first-user persistence')
})

test('self-service account deletion removes every matching identity record', () => {
  const source = read('cloudfunctions/login/index.js')
  const deletion = source.slice(source.indexOf("if (type === 'deleteAccount')"))

  assert.match(deletion, /where\(\{ openid: OPENID, status: 'active' \}\)[\s\S]{0,80}limit\(1\)/)
  assert.match(deletion, /where\(\{ patient_openid: OPENID, status: 'pending' \}\)[\s\S]{0,80}limit\(1\)/)
  assert.match(deletion, /await anonymizeAppointments\(OPENID, anonymizedId\)/)
  assert.match(deletion, /await deleteUsersByOpenid\(OPENID\)/)
  assert.match(deletion, /async function deleteUsersByOpenid[\s\S]*while \(true\)[\s\S]*where\(\{ openid \}\)[\s\S]*limit\(50\)/)
  assert.match(deletion, /cloud\.deleteFile\(\{ fileList: \[avatarFileId\] \}\)/)
  assert.match(deletion, /collection\('users'\)\.doc\(user\._id\)\.remove\(\)/)
  assert.doesNotMatch(deletion, /cloud\.deleteFile\(\{ fileList: \[avatarFileId\] \}\)\.catch/)
})

test('admin deletion rejects pending bookings, erases identities and writes a non-personal tombstone', () => {
  const source = read('cloudfunctions/admin/index.js')
  const deletion = source.slice(
    source.indexOf('async function deleteCustomer'),
    source.indexOf('async function getAdminAppointments')
  )

  assert.match(deletion, /where\(\{ patient_openid: openid, status: 'pending' \}\)/)
  assert.match(deletion, /const openidHash = crypto\.createHash\('sha256'\)\.update\(openid\)\.digest\('hex'\)[\s\S]{0,100}const anonymizedId = `deleted_\$\{openidHash\.slice\(0, 32\)\}`/)
  assert.match(deletion, /patient_openid: anonymizedId/)
  assert.match(deletion, /patient_anonymized_at: db\.serverDate\(\)/)
  assert.match(deletion, /const duplicates = users\.data\.filter\(user => user\._id !== data\.id\)/)
  assert.match(deletion, /cloud\.deleteFile\(\{ fileList: \[avatarFileId\] \}\)/)
  assert.match(deletion, /collection\('users'\)\.doc\(user\._id\)\.remove\(\)/)
  assert.match(deletion, /const tombstoneId = `user_\$\{openidHash\}`/)
  assert.match(deletion, /deleted_by_admin: true/)
  assert.match(deletion, /doc\(tombstoneId\)\.set\(\{ data: tombstone \}\)/)
  const tombstone = deletion.match(/const tombstone = \{([\s\S]*?)\n\s*\}/)
  assert.ok(tombstone)
  assert.doesNotMatch(tombstone[1], /\bopenid:/)
})
