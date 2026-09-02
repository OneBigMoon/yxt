const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const DEFAULT_NICK_NAME = '微信用户'
const PUBLIC_PROFILE_ERROR_MESSAGES = new Set([
  '昵称包含不适宜内容，请修改后重试',
  '头像文件无效，请重新选择',
  '头像格式不支持，请重新选择',
  '头像包含不适宜内容，请重新选择',
  '内容安全检测暂不可用，请稍后重试'
])

async function findActiveTechnicianByPhone(phoneNumber, openid) {
  if (!phoneNumber) {
    return null
  }

  const techRes = await db.collection('technicians')
    .where({
      phone: phoneNumber,
      status: 'active'
    })
    .get()

  const technicianInfo = techRes.data[0] || null
  if (technicianInfo && technicianInfo.openid && technicianInfo.openid !== openid) {
    return null
  }

  if (technicianInfo && !technicianInfo.openid) {
    await db.collection('technicians')
      .doc(technicianInfo._id)
      .update({
        data: { openid, updated_at: db.serverDate() }
      })
  }

  return technicianInfo
}

async function findActiveTechnicianForUser(openid, phoneNumber) {
  const openidTechRes = await db.collection('technicians')
    .where({
      openid,
      status: 'active'
    })
    .get()

  if (openidTechRes.data.length > 0) {
    return openidTechRes.data[0]
  }

  return await findActiveTechnicianByPhone(phoneNumber, openid)
}

function buildLoginData(openid, userData, role, technicianInfo, isNewUser = false) {
  return {
    // ponytail: compatibility for released clients; remove after the minimum supported version no longer requires openid.
    openid,
    role,
    nick_name: userData.nick_name || DEFAULT_NICK_NAME,
    avatar_url: userData.avatar_url || '',
    phone: userData.phone || '',
    technician_id: technicianInfo ? technicianInfo._id : null,
    isNewUser,
    is_blacklisted: userData.is_blacklisted || false
  }
}

function userDocumentId(openid) {
  return `user_${crypto.createHash('sha256').update(openid).digest('hex')}`
}

async function assertSafeNickname(content, openid) {
  try {
    const result = await cloud.openapi.security.msgSecCheck({
      content,
      version: 2,
      scene: 1,
      openid
    })
    const suggest = result && result.result && result.result.suggest
    if (suggest && suggest !== 'pass') {
      throw new Error('NICKNAME_REJECTED')
    }
  } catch (err) {
    if (err && (err.message === 'NICKNAME_REJECTED' || Number(err.errCode) === 87014)) {
      throw new Error('昵称包含不适宜内容，请修改后重试')
    }
    console.error('LOGIN_NICKNAME_SECURITY_CHECK_FAILED')
    throw new Error('内容安全检测暂不可用，请稍后重试')
  }
}

function detectImageContentType(buffer) {
  if (buffer && buffer.length >= 4 && buffer.subarray(0, 4).toString('hex') === '89504e47') {
    return 'image/png'
  }
  if (buffer && buffer.length >= 3 && buffer.subarray(0, 3).toString('hex') === 'ffd8ff') {
    return 'image/jpeg'
  }
  return ''
}

async function assertSafeAvatar(fileId) {
  if (!/^cloud:\/\/[^/]+\/avatars\//.test(fileId)) {
    throw new Error('头像文件无效，请重新选择')
  }

  try {
    const downloadRes = await cloud.downloadFile({ fileID: fileId })
    const fileContent = downloadRes && downloadRes.fileContent
    const contentType = detectImageContentType(fileContent)
    if (!contentType) {
      throw new Error('AVATAR_FORMAT_INVALID')
    }
    await cloud.openapi.security.imgSecCheck({
      media: {
        contentType,
        value: fileContent
      }
    })
  } catch (err) {
    if (err && (err.message === 'AVATAR_FORMAT_INVALID' || Number(err.errCode) === 87014)) {
      throw new Error(err.message === 'AVATAR_FORMAT_INVALID'
        ? '头像格式不支持，请重新选择'
        : '头像包含不适宜内容，请重新选择')
    }
    console.error('LOGIN_AVATAR_SECURITY_CHECK_FAILED')
    throw new Error('内容安全检测暂不可用，请稍后重试')
  }
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { type } = event

  try {
    if (!OPENID) {
      return { code: -1, message: '登录状态异常，请重新登录' }
    }

    if (type === 'login') {
      const { userInfo, phoneCode } = event

      let phoneNumber = ''

      if (!phoneCode) {
        return { code: -1, message: '请授权手机号完成快捷登录' }
      }

      try {
        const phoneRes = await Promise.race([
          cloud.openapi.phonenumber.getPhoneNumber({ code: phoneCode }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('获取手机号超时')), 5000))
        ])
        const phoneInfo = phoneRes.phone_info || phoneRes.phoneInfo
        const errCode = phoneRes.errcode === undefined ? phoneRes.errCode : phoneRes.errcode
        if (phoneRes && errCode === 0 && phoneInfo && phoneInfo.phoneNumber) {
          phoneNumber = phoneInfo.phoneNumber
        }
      } catch (err) {
        console.error('LOGIN_PHONE_LOOKUP_FAILED')
      }

      if (!phoneNumber) {
        return { code: -1, message: '手机号授权失败，请重新登录' }
      }

      const identityRes = await db.collection('users')
        .where({ _id: userDocumentId(OPENID) })
        .limit(1)
        .get()
      const identityRecord = identityRes.data[0]
      if (identityRecord && identityRecord.status === 'deleted' && identityRecord.deleted_by_admin) {
        return { code: -1, message: '账号不可用，请联系管理员' }
      }
      if (identityRecord && identityRecord.status === 'deleted') {
        return { code: -1, message: '账号已注销' }
      }

      let role = 'patient'
      let technicianInfo = null
      let isNewUser = false

      if (phoneNumber) {
        try {
          technicianInfo = await findActiveTechnicianByPhone(phoneNumber, OPENID)
          if (technicianInfo) {
            role = 'technician'
          }
        } catch (err) {
          console.error('LOGIN_TECHNICIAN_LOOKUP_FAILED')
        }
      }

      const userRes = await db.collection('users')
        .where({ openid: OPENID })
        .get()

      let userData

      const loginNickName = userInfo && userInfo.nickName ? userInfo.nickName : DEFAULT_NICK_NAME
      const existingUser = userRes.data[0]
      if (userInfo && userInfo.nickName && loginNickName !== (existingUser && existingUser.nick_name)) {
        if (loginNickName.length > 32) {
          return { code: -1, message: '昵称不能超过32个字符' }
        }
        await assertSafeNickname(loginNickName, OPENID)
      }

      if (existingUser) {
        const updateData = {
          role,
          last_login_at: db.serverDate(),
          updated_at: db.serverDate()
        }
        if (userInfo && userInfo.nickName) updateData.nick_name = loginNickName
        if (!userRes.data[0].nick_name) updateData.nick_name = DEFAULT_NICK_NAME
        if (phoneNumber) updateData.phone = phoneNumber

        await db.collection('users')
          .doc(existingUser._id)
          .update({ data: updateData })

        userData = {
          ...existingUser,
          ...updateData,
          role: role
        }
      } else {
        isNewUser = true
        const newUser = {
          openid: OPENID,
          nick_name: loginNickName,
          avatar_url: '',
          phone: phoneNumber || '',
          role: role,
          is_blacklisted: false,
          notes: '',
          register_source: 'wechat_phone_quick_login',
          profile_completed: Boolean(userInfo && userInfo.nickName),
          last_login_at: db.serverDate(),
          registered_at: db.serverDate(),
          created_at: db.serverDate(),
          updated_at: db.serverDate()
        }

        await db.collection('users').doc(userDocumentId(OPENID)).set({ data: newUser })
        userData = {
          _id: userDocumentId(OPENID),
          ...newUser
        }
      }

      return {
        code: 0,
        data: buildLoginData(OPENID, userData, role, technicianInfo, isNewUser)
      }
    }

    if (type === 'refresh') {
      const userRes = await db.collection('users')
        .where({ openid: OPENID })
        .get()

      if (userRes.data.length === 0) {
        return { code: 0, data: null }
      }

      const existingUser = userRes.data[0]
      let role = 'patient'
      let technicianInfo = null

      try {
        technicianInfo = await findActiveTechnicianForUser(OPENID, existingUser.phone || '')
        if (technicianInfo) {
          role = 'technician'
        }
      } catch (err) {
        console.error('LOGIN_TECHNICIAN_REFRESH_FAILED')
      }

      const updateData = {
        role,
        updated_at: db.serverDate()
      }
      if (!existingUser.nick_name) {
        updateData.nick_name = DEFAULT_NICK_NAME
      }

      await db.collection('users')
        .doc(existingUser._id)
        .update({ data: updateData })

      return {
        code: 0,
        data: buildLoginData(OPENID, { ...existingUser, ...updateData }, role, technicianInfo, false)
      }
    }

    if (type === 'updateProfile') {
      const { nickName, avatarUrl } = event

      const userRes = await db.collection('users')
        .where({ openid: OPENID })
        .get()

      if (userRes.data.length === 0) {
        return { code: -1, message: '用户不存在' }
      }

      const existingUser = userRes.data[0]
      const normalizedNickName = String(nickName || '').trim()
      const normalizedAvatarUrl = String(avatarUrl || '').trim()
      if (normalizedNickName.length > 32) {
        return { code: -1, message: '昵称不能超过32个字符' }
      }

      if (normalizedNickName && normalizedNickName !== existingUser.nick_name) {
        await assertSafeNickname(normalizedNickName, OPENID)
      }
      if (normalizedAvatarUrl && normalizedAvatarUrl !== existingUser.avatar_url) {
        try {
          await assertSafeAvatar(normalizedAvatarUrl)
        } catch (err) {
          if (normalizedAvatarUrl.startsWith('cloud://')) {
            await cloud.deleteFile({ fileList: [normalizedAvatarUrl] }).catch(() => {})
          }
          throw err
        }
      }

      const updateData = { updated_at: db.serverDate() }
      if (normalizedNickName) updateData.nick_name = normalizedNickName
      if (normalizedAvatarUrl) updateData.avatar_url = normalizedAvatarUrl

      await db.collection('users')
        .doc(existingUser._id)
        .update({ data: updateData })

      return {
        code: 0,
        data: {
          openid: OPENID,
          role: existingUser.role,
          nick_name: normalizedNickName || existingUser.nick_name,
          avatar_url: normalizedAvatarUrl || existingUser.avatar_url || '',
          phone: existingUser.phone || ''
        }
      }
    }

    if (type === 'deleteAccount') {
      const userRes = await db.collection('users')
        .where({ openid: OPENID })
        .get()
      const technicianRes = await db.collection('technicians')
        .where({ openid: OPENID, status: 'active' })
        .limit(1)
        .get()
      if (technicianRes.data.length > 0) {
        return { code: -1, message: '工作人员账号请先联系管理员解除顾问身份' }
      }

      const pendingRes = await db.collection('appointments')
        .where({ patient_openid: OPENID, status: 'pending' })
        .limit(1)
        .get()
      if (pendingRes.data.length > 0) {
        return { code: -1, message: '请先取消待到店预约，再注销账号' }
      }

      const openidHash = crypto.createHash('sha256').update(OPENID).digest('hex')
      const anonymizedId = `deleted_${openidHash.slice(0, 32)}`
      const tombstoneId = userDocumentId(OPENID)
      const identityUser = userRes.data.find(user => user._id === tombstoneId)
      const avatarFileId = String((identityUser && identityUser.avatar_url) || '')
      const tombstone = {
        status: 'deleted',
        deleted_by_admin: false,
        deleted_at: db.serverDate(),
        created_at: db.serverDate(),
        updated_at: db.serverDate()
      }
      await db.collection('users').doc(tombstoneId).set({ data: tombstone })
      if (/^cloud:\/\/[^/]+\/avatars\//.test(avatarFileId)) {
        await cloud.deleteFile({ fileList: [avatarFileId] })
      }
      await anonymizeAppointments(OPENID, anonymizedId)
      await deleteUsersByOpenid(OPENID)
      return { code: 0, data: { deleted: true } }
    }

    return { code: -1, message: '未知操作: ' + type }
  } catch (err) {
    console.error('LOGIN_OPERATION_FAILED')
    const message = err && err.message
    return {
      code: -1,
      message: PUBLIC_PROFILE_ERROR_MESSAGES.has(message) ? message : '操作失败，请稍后重试'
    }
  }
}

async function anonymizeAppointments(openid, anonymizedId) {
  while (true) {
    const appointmentRes = await db.collection('appointments')
      .where({ patient_openid: openid })
      .field({ _id: true })
      .limit(50)
      .get()
    const appointments = appointmentRes.data || []
    if (appointments.length === 0) return

    await Promise.all(appointments.map(appointment => {
      return db.collection('appointments').doc(appointment._id).update({
        data: {
          patient_openid: anonymizedId,
          personal_data_deleted_at: db.serverDate()
        }
      })
    }))
  }
}

async function deleteUsersByOpenid(openid) {
  while (true) {
    const userRes = await db.collection('users')
      .where({ openid })
      .field({ _id: true, avatar_url: true })
      .limit(50)
      .get()
    const users = userRes.data || []
    if (users.length === 0) return

    for (const user of users) {
      const avatarFileId = String(user.avatar_url || '')
      if (/^cloud:\/\/[^/]+\/avatars\//.test(avatarFileId)) {
        await cloud.deleteFile({ fileList: [avatarFileId] })
      }
      await db.collection('users').doc(user._id).remove()
    }
  }
}
