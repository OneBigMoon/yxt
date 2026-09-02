const extractErrorMessage = (err) => {
  if (!err) {
    return '云函数调用失败'
  }

  if (typeof err === 'string') {
    return err
  }

  if (err.message) {
    return err.message
  }

  if (err.errMsg) {
    return err.errMsg
  }

  return '云函数调用失败'
}

const buildCloudFunctionError = (name, requestTag, err) => {
  let rawMessage = extractErrorMessage(err)
  let message = rawMessage

  if (message === 'timeout' || message.includes('timeout')) {
    message = `调用云函数 ${name} 失败（requestTag=${requestTag}, timeout）`
  } else if (err && (err.errCode || err.code)) {
    message = `调用云函数 ${name} 调用失败（errCode=${err.errCode || err.code}）`
  }

  const normalizedError = new Error(message)
  normalizedError.name = 'CloudFunctionError'
  normalizedError.__cloudFunction = name
  normalizedError.__requestTag = requestTag
  normalizedError.__errorPayload = err
  normalizedError.__errCode = err && (err.errCode || err.code)
  return normalizedError
}

module.exports = {
  buildCloudFunctionError
}
