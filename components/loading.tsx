export default function Loading() {
  return (
    <div className="loading" style={{
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      color: 'white',
      fontSize: '18px',
      fontFamily: 'Arial, sans-serif'
    }}>
      Loading...
    </div>
  )
}
