<?php 
   require "php/db.php";

   $data = $_POST;
   if( isset($data['do_login']) )
   {
   	$errors = array();
   	$user = R::findone('users', 'login = ?', array($data['
   		login']));
   	if( $user )
   {
   	  //логин существует
      if( password_verify($data['password'], $user->password)
      	) {
      	// Всё хорошо, логин пользователя

      	$_SESSION['logger_user'] = $user;
       echo '<div style="color: green;">Вы авторизованны!<br/>
       Можете перейти на <a href="/">главную</a> страницу!</div><hr>';

      } else
      {
      	$errors[] = 'Неверно введён пароль';
      }
    } else
    {
    	$errors[] = 'Пользователь с таким логином не найден';
    }

    if( ! empty($errors) )
    {
    	echo '<div style="color: red;">'.array_shift($errors).'<
    	   /div><hr>';
    }

  }

 ?>
 
  <form action="login.php" method="POST">

    <p>
    	<p><strong>Логин</strong>:</p>
    	<input type="text" name="login" value="<?php echo @$data['
    	login']; ?>">
    </p>  

    <p>
    	<p><strong>Пароль</strong>:</p>
    	<input type="password" name="password" value="<?php echo @$data['
    	password']; ?>">
    </p>  

    <p>
    	<button type="submit" name="do_login">Войти</button>
    </p>

    </form>