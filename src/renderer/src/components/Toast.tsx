import { useEffect } from 'react'

export default function Toast({
  message,
  onDone
}: {
  message: string
  onDone: () => void
}): JSX.Element {
  useEffect(() => {
    const timer = setTimeout(onDone, 4500)
    return () => clearTimeout(timer)
  }, [message, onDone])

  return (
    <div className="toast" onClick={onDone}>
      {message}
    </div>
  )
}
